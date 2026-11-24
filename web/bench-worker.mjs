import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { cpus, platform, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';

const sha256 = (content) => createHash('sha256').update(content).digest('hex');
const assets = ['worker.mjs', 'worker-client.mjs', 'index.mjs', 'generated/core.mjs', 'generated/core.wasm'];
const HELP = `Usage: node web/bench-worker.mjs --baseline DIR [--candidate DIR] --fixtures DIR --output FILE
  --baseline / --candidate  Separate built static web roots with sdk/ assets.
  --fixtures DIR            Directory of resource-fixtures.json from benchmark.py --mode fixtures.
  --output FILE             JSON report and FILE.trials.jsonl checkpoint. Do not reuse for another experiment.
  --profile                 Baseline-only diagnostic, defaults to Wasm GC, NEAR=0, 4096 byte chunks, 0+1 trials.
  --warmup N                Session pre-runs per version and case, default 2. Every trial creates a new Worker.
  --repeats N               Formal samples per version and case, default 5.
  --backends js,wasm-gc --nears 0,3 --chunks 4096,1   Select cases, defaults shown.
  --timeout-ms N            Per-trial limit, default 180000. A failure is kept in the report and checkpoints.
  --resume                  Reuse a matching checkpoint and rerun interrupted trials.
  --help                    Show this help. Set MOONJLS_CHROME to override the Chrome binary.
The timed boundary is before Worker creation through done and the final ACK. Fixture fetch and DOM are excluded.`;

const { values: flags } = parseArgs({ options: Object.fromEntries([
  ...['baseline', 'candidate', 'fixtures', 'output', 'warmup', 'repeats', 'backends', 'nears', 'chunks', 'timeout-ms'].map((key) => [key, { type: 'string' }]),
  ...['profile', 'resume', 'help'].map((key) => [key, { type: 'boolean' }]),
]) });
if (flags.help) {
  console.log(HELP);
  process.exit(0);
}
for (const required of ['baseline', 'fixtures', 'output']) if (!flags[required]) throw new Error(`Expected --${required}.\n${HELP}`);
if (flags.profile && flags.candidate) throw new Error('--profile is baseline-only');
const profile = !!flags.profile;

function integer(value, fallback, min, max) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`Expected an integer from ${min} to ${max}, got ${value}`);
  return number;
}

function selection(value, fallback, allowed) {
  const result = (value ?? fallback).split(',');
  if (result.some((item) => !allowed.includes(item)) || new Set(result).size !== result.length) throw new Error(`Expected a list from ${allowed.join(',')}, got ${value}`);
  return result;
}

const warmup = integer(flags.warmup, profile ? 0 : 2, 0, 10);
const repeats = integer(flags.repeats, profile ? 1 : 5, 1, 10);
const timeoutMs = integer(flags['timeout-ms'], 180000, 100, 900000);
const backends = selection(flags.backends, profile ? 'wasm-gc' : 'wasm-gc,js', ['js', 'wasm-gc']);
const nears = selection(flags.nears, profile ? '0' : '0,3', ['0', '3']).map(Number);
const chunks = selection(flags.chunks, profile ? '4096' : '4096,1', ['4096', '1']).map(Number);
const variants = flags.candidate ? ['baseline', 'candidate'] : ['baseline'];
const width = 512;
const height = 4096;
const output = resolve(flags.output);
const journal = `${output}.trials.jsonl`;
await mkdir(dirname(output), { recursive: true });

function insert(source, search, replacement) {
  if (source.indexOf(search) < 0 || source.indexOf(search) !== source.lastIndexOf(search)) throw new Error(`Profile marker missing or ambiguous: ${search}`);
  return source.replace(search, replacement);
}

function profiled(name, original) {
  if (name !== 'index.mjs' && name !== 'worker.mjs') return original;
  let source = original.toString().replaceAll('\r\n', '\n');
  if (name === 'index.mjs') {
    source = `const workerProfile = { stagingMs: 0, bindingStepMs: 0, materializationMs: 0, stageCalls: 0, stepCalls: 0, stageBytes: 0, materializedBytes: 0 };\nglobalThis.moonjlsWorkerProfile = workerProfile;\n${source}`;
    source = insert(source, '  stage(input) {', '  stage(input) {\n    const profileStart = performance.now();');
    source = insert(source, "    this.#status = 'Staged';", "    this.#status = 'Staged';\n    workerProfile.stagingMs += performance.now() - profileStart;\n    workerProfile.stageCalls++;\n    workerProfile.stageBytes += this.#length; // Each staged decoder byte is copied into staging and Bytes.");
    source = insert(source, '    const code = this.#encoding', '    const coreStart = performance.now();\n    const code = this.#encoding');
    source = insert(source, '    const consumed = this.#encoding', '    workerProfile.bindingStepMs += performance.now() - coreStart;\n    workerProfile.stepCalls++;\n    const consumed = this.#encoding');
    source = insert(source, '    let chunk;', '    const outputStart = performance.now();\n    let chunk;');
    source = insert(source, '    return { status: this.#status, consumed, produced:', '    workerProfile.materializationMs += performance.now() - outputStart;\n    workerProfile.materializedBytes += chunk?.byteLength ?? 0;\n    return { status: this.#status, consumed, produced:');
  } else {
    const waits = 'const waitMs = { needInput: 0, progress: 0, row: 0, bytes: 0 };';
    source = insert(source, 'let active = false;', `${waits}\nlet active = false;`);
    source = insert(source, '    pending = { seq, resolve, reject };', '    const beforeSend = performance.now();\n    pending = { seq, resolve(value) { waitMs[type] += performance.now() - beforeSend; resolve(value); }, reject };');
    source = insert(source, "finish('done', { ...result, backend: core.backend, loadMs: core.loadMs });", "finish('done', { ...result, backend: core.backend, loadMs: core.loadMs, profile: { ...globalThis.moonjlsWorkerProfile, waitMs } });");
  }
  return Buffer.from(source);
}

const responses = new Map();
const serverReceipts = new Map();
function serve(path, content, type) {
  const record = { bytes: content.byteLength, sha256: sha256(content), type };
  responses.set(path, { content, record });
  return record;
}

const fixtureRoot = resolve(flags.fixtures);
const fixtureManifest = await readFile(join(fixtureRoot, 'resource-fixtures.json'));
const fixtureInfo = JSON.parse(fixtureManifest);
const fixtureRecords = [];
for (const near of nears) {
  const fixture = fixtureInfo.fixtures.find((item) => item.width === width && item.height === height && item.bits === 16 && item.near === near);
  if (!fixture) throw new Error(`Missing ${width}×${height} 16-bit fixture NEAR=${near}`);
  assert.ok(fixture.maxError <= near);
  if (!near) assert.equal(fixture.sourceSamples.sha256, fixture.reconstructedSamples.sha256);
  for (const [recordName, extension] of [['encoded', 'jls'], ['reconstructedSamples', 'raw']]) {
    const expected = fixture[recordName];
    const loaded = await readFile(join(fixtureRoot, expected.path));
    const record = serve(`/fixtures/${near}.${extension}`, loaded, 'application/octet-stream');
    assert.equal(record.bytes, expected.bytes);
    assert.equal(record.sha256, expected.sha256);
  }
  fixtureRecords.push(fixture);
}

const assetRecords = {};
for (const variant of variants) {
  assetRecords[variant] = {};
  for (const name of assets) {
    const content = await readFile(join(resolve(flags[variant]), 'sdk', name));
    const served = profile ? profiled(name, content) : content;
    assetRecords[variant][name] = {
      ...serve(`/${variant}/sdk/${name}`, served, name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript'),
      originalSha256: sha256(content), instrumented: served !== content,
    };
  }
}
if (flags.candidate) {
  for (const name of assets.filter((name) => name !== 'worker.mjs')) {
    assert.equal(assetRecords.baseline[name].sha256, assetRecords.candidate[name].sha256, `The experiment must keep ${name} fixed`);
  }
  assert.notEqual(assetRecords.baseline['worker.mjs'].sha256, assetRecords.candidate['worker.mjs'].sha256, 'The two worker.mjs artifacts are identical');
}
const driver = await readFile(new URL('./bench-worker-page.mjs', import.meta.url));
serve('/driver.mjs', driver, 'text/javascript');
serve('/', Buffer.from('<!doctype html><html><meta charset="utf-8"><title>MoonJLS Worker benchmark</title></html>'), 'text/html');

const server = createServer((request, reply) => {
  const path = request.url;
  const resource = responses.get(path);
  if (!resource || request.method !== 'GET') {
    reply.writeHead(404).end();
    return;
  }
  const { content, record } = resource;
  const roles = serverReceipts.get(path) ?? {};
  const referer = request.headers.referer ? new URL(request.headers.referer).pathname : '';
  const role = `${request.headers['sec-fetch-dest'] ?? 'unspecified'} <- ${referer}`;
  roles[role] = (roles[role] ?? 0) + 1;
  serverReceipts.set(path, roles);
  reply.writeHead(200, { 'Content-Type': record.type, 'Content-Length': record.bytes, 'Cache-Control': 'no-store', 'X-MoonJLS-SHA256': record.sha256 });
  reply.end(content);
});

const connection = await new Promise((accept, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => accept(server.address()));
});
const version = process.env.MOONJLS_CHROME;
let browser;
const trials = [];
const failures = [];
const browserReceipts = new Map();
const browserEvidence = new Map();
const schemaVersion = 1;
const median = (items) => {
  const ordered = [...items].sort((a, b) => a - b);
  const middle = ordered.length >> 1;
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
};

function summarize() {
  const groups = new Map();
  for (const trial of trials.filter(({ phase }) => phase === 'formal')) {
    const { variant, backend, near, chunk } = trial;
    const key = `${variant}/${backend}/${near}/${chunk}`;
    if (!groups.has(key)) groups.set(key, { variant, backend, near, chunk, wallMs: [], firstRowWallMs: [] });
    const group = groups.get(key);
    group.wallMs.push(trial.wallMs);
    group.firstRowWallMs.push(trial.firstRowWallMs);
  }
  return [...groups.values()].map((group) => ({ ...group, summary: Object.fromEntries(['wallMs', 'firstRowWallMs'].map((key) => {
    const items = group[key];
    const center = median(items);
    return [key, { median: center, min: Math.min(...items), max: Math.max(...items), mad: median(items.map((time) => Math.abs(time - center))) }];
  })) }));
}

try {
  browser = await chromium.launch(version ? { executablePath: version } : { channel: 'chrome' });
  const commandArgs = process.argv.slice(2).filter((arg) => arg !== '--resume');
  const environment = { browser: browser.version(), node: process.version, platform: platform(), release: release(), cpu: cpus()[0].model, logicalCpus: cpus().length };
  const info = {
    schemaVersion, commandArgs, environment, profile, warmup, repeats, timeoutMs, backends, nears, chunks,
    fixtures: { manifestSha256: sha256(fixtureManifest), oracle: fixtureInfo.oracle, records: fixtureRecords },
    assetRecords, harness: { driver: sha256(driver), runner: sha256(await readFile(new URL(import.meta.url))) },
    timing: 'Wall time from just before Worker creation through done after final acknowledgement. New Worker per sample. Fixture buffers and main module setup are outside timing. Timed samples include bounded source copying, MessagePort transport, output comparison and lightweight message counters. Profile adds per-step/callback timers. Worker waits include host source/sink and transport time and may overlap other recorded timing.',
  };
  const signature = sha256(JSON.stringify(info));
  const save = async () => writeFile(output, `${JSON.stringify({ ...info, signature, savedAt: new Date().toISOString(), trials, failures, summary: summarize(),
    actualBrowserResponses: Object.fromEntries(browserReceipts), serverDelivered: Object.fromEntries(serverReceipts) }, null, 2)}\n`);
  const journalExists = await readFile(journal, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (journalExists !== null) {
    if (!flags.resume) throw new Error(`Checkpoint exists at ${journal}. Use --resume or choose a new output.`);
    const [header, ...entries] = journalExists.trim().split('\n').map(JSON.parse);
    assert.equal(header.signature, signature, 'Checkpoint inputs or toolchain have changed');
    for (const entry of entries) (entry.phase === 'failed' ? failures : trials).push(entry);
    const previous = JSON.parse(await readFile(output, 'utf8').catch(() => '{}'));
    for (const [path, item] of Object.entries(previous.actualBrowserResponses ?? {})) browserReceipts.set(path, item);
    for (const [path, roles] of Object.entries(previous.serverDelivered ?? {})) serverReceipts.set(path, roles);
  } else {
    await writeFile(journal, `${JSON.stringify({ signature })}\n`, { flag: 'wx' });
  }
  await save();

  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  context.on('response', (response) => {
    const path = new URL(response.url()).pathname;
    const known = responses.get(path);
    if (!known || browserEvidence.has(path)) return;
    browserEvidence.set(path, (async () => {
      const advertised = (await response.allHeaders())['x-moonjls-sha256'];
      assert.equal(advertised, known.record.sha256);
      // Browser responses for dedicated workers can be unavailable through this API.
      // The server receipt still verifies the exact buffers sent to the requesting worker URL.
      const body = await response.body().catch(() => null);
      if (body) assert.equal(sha256(body), known.record.sha256);
      browserReceipts.set(path, { status: response.status(), deliveredSha256: advertised, browserBodySha256: body ? sha256(body) : null });
    })().catch((error) => { pageErrors.push(error.message); }));
  });
  await page.goto(`http://127.0.0.1:${connection.port}/`);
  await page.evaluate(async () => { globalThis.runWorkerTrial = (await import('/driver.mjs')).workerTrial; });

  for (const chunk of chunks) for (const near of nears) for (const backend of backends) {
    for (let index = 0; index < warmup + repeats; index++) {
      const order = index % 2 === 0 ? variants : [...variants].reverse();
      for (const variant of order) {
        const phase = index < warmup ? 'warmup' : 'formal';
        const trial = { variant, backend, near, chunk, phase, index: index < warmup ? index + 1 : index - warmup + 1 };
        if (trials.some((entry) => Object.entries(trial).every(([key, value]) => entry[key] === value))) continue;
        try {
          let timer;
          const result = await Promise.race([
            page.evaluate((options) => globalThis.runWorkerTrial(options), { ...trial, width, height, timeoutMs, profile }),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Worker test exceeded ${timeoutMs} ms`)), timeoutMs + 2000); }),
          ]).finally(() => clearTimeout(timer));
          await Promise.all(browserEvidence.values());
          assert.deepEqual(pageErrors, []);
          const completed = { ...trial, ...result };
          trials.push(completed);
          await appendFile(journal, `${JSON.stringify(completed)}\n`);
          console.log(JSON.stringify({ ...trial, wallMs: result.wallMs, firstRowWallMs: result.firstRowWallMs, progress: result.messages.received.progress }));
        } catch (error) {
          const failure = { ...trial, intendedPhase: phase, phase: 'failed', error: String(error), at: new Date().toISOString() };
          failures.push(failure);
          await appendFile(journal, `${JSON.stringify(failure)}\n`);
          throw error;
        } finally {
          await save();
        }
      }
    }
  }
  for (const variant of variants) {
    for (const name of ['worker-client.mjs', 'worker.mjs', 'index.mjs', ...backends.map((backend) => backend === 'js' ? 'generated/core.mjs' : 'generated/core.wasm')]) {
      assert.ok(serverReceipts.has(`/${variant}/sdk/${name}`), `No browser load observed for ${variant}/sdk/${name}`);
    }
  }
  await save();
} finally {
  await browser?.close();
  await new Promise((accept) => server.close(accept));
}
